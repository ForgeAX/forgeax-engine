/* Direct source evaluator for offline fidelity verification, independent of bake/runtime interpolation. */
#include "../src/native/bridge.c"
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    ufbx_load_opts opts = {0}; opts.target_axes = ufbx_axes_right_handed_y_up;
    opts.target_unit_meters = 1.0; opts.space_conversion = UFBX_SPACE_CONVERSION_TRANSFORM_ROOT;
    ufbx_error error; ufbx_scene *scene = ufbx_load_file(argv[1], &opts, &error);
    if (!scene) return 3;
    int samples = atoi(argv[2]); if (samples < 2 || samples > 10001) return 4;
    Buf b; buf_init(&b); buf_char(&b,'['); int first = 1;
    for (size_t si = 0; si < scene->anim_stacks.count; si++) {
        ufbx_anim_stack *stack = scene->anim_stacks.data[si];
        if (stack->time_end <= stack->time_begin) continue;
        if (!first) buf_char(&b,','); first = 0;
        buf_str(&b,"{\"name\":"); buf_quoted(&b,stack->name.data ? stack->name.data : "");
        buf_str(&b,",\"duration\":"); buf_double(&b,stack->time_end-stack->time_begin);
        buf_str(&b,",\"nodes\":["); int first_node = 1;
        for (size_t ni = 0; ni < scene->nodes.count; ni++) {
            ufbx_node *node = scene->nodes.data[ni]; if (skip_node(node)) continue;
            if (!first_node) buf_char(&b,','); first_node = 0;
            char path[1024]; build_node_path(path,sizeof(path),node);
            buf_str(&b,"{\"path\":"); buf_quoted(&b,path); buf_str(&b,",\"samples\":[");
            for (int i = 0; i < samples; i++) {
                if (i) buf_char(&b,',');
                double time = (stack->time_end-stack->time_begin)*(i+0.371)/(samples-0.258);
                ufbx_transform t = ufbx_evaluate_transform(stack->anim,node,stack->time_begin+time);
                buf_char(&b,'['); buf_double(&b,time);
                double v[] = {t.translation.x,t.translation.y,t.translation.z,t.rotation.x,t.rotation.y,t.rotation.z,t.rotation.w,t.scale.x,t.scale.y,t.scale.z};
                for (int c=0;c<10;c++) {buf_char(&b,',');buf_double(&b,v[c]);} buf_char(&b,']');
            }
            buf_str(&b,"]}");
        }
        buf_str(&b,"]}");
    }
    buf_char(&b,']'); puts(b.data); free(b.data); ufbx_free_scene(scene); return 0;
}
